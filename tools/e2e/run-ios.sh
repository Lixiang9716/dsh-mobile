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
# retry loops. Overall deadline 600s (the step-3 reboot kills WDA; its
# re-bootstrap can take MINUTES on a cold sim: the runner binds its server
# long after the process is alive) — on expiry it fails loud with the last
# 50 log lines.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# ---- live-calibration constants -------------------------------------------
# COORDINATE LAW (calibrated live on iOS 26.5 / 3x device, 2026-09-20): idb
# tap/swipe coordinates are SCREENSHOT PIXELS / 2 — fb-idb assumes a 2x
# Retina surface, so on a 3x device (1206x2622 px = 402x874 pt) every input
# lands at 2/3 of the points you may have intended. Derive every constant
# from a screenshot: (px_x/2, px_y/2). Verified: grid cells, chrome buttons,
# the search field. `idb ui describe-all` is DEAD on this runtime (returns
# one Application element; describe-point works but needs coordinates — the
# oracle is circular), so constants are PRIMARY here; the describe-all label
# path stays wired as the first choice for runtimes where it works.
PT_ALLOW=(320 570)             # notification permission alert: 允许/Allow (px 641,1140 / 2)
PT_APPROVE=(300 720)           # in-app approval dialog: "Approve" (check 03-*.png)
PT_BANNER=(150 130)            # notification banner body (top of screen)
SWIPE_PULL=(150 60 150 600)    # pull-down gesture when banner is collapsed
PT_SEARCH=(298 248)           # Files sheet search field (re-derived 2026-09-21 from screens/05-picker-search.png per the coordinate law: field at px ~(596,496) / 2; the old (201,126) mapped to the sheet TITLE row — tap missed, typing never landed, empty Recents left zero rows for the tile press — surprise drivepickers-ptsearch-calibration-201126)
PT_FILES_TILE=(81 356)        # search-result grid cell (re-derived 2026-09-21 from 05b-picker-results.png after the search-submission fix: single "notes" tile thumbnail spans px (92..233, 617..807), center ~(163,712) / 2 per the coordinate law — the old (102,447) mapped to px (204,894), the label row BELOW the thumbnail, and the press never selected; wda_session element probes confirm WDA's AX tree does NOT expose result cells, so the press stays coordinate-based)
PT_ALERT_DENY=(146 570)        # system alert left button 不允许 (px 293,1140 / 2); harmless on empty grid
BANNER_LABEL="DSH E2E"         # notify() title — locale-independent, banner carries it

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART="hosts/ios/artifacts/m2-gateway"
SKIP_BUILD=0
NO_REBOOT=0
SKIP_INSTALL=0
APP_BUNDLE_ID=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
# The step-3 REBOOT kills any running WDA, so step 5 re-bootstraps it on the
# freshly booted sim — test-manager daemons can take minutes there, and the
# system-UI legs (banner/picker) hang without it. Budget accordingly:
# overall 900s, WDA bootstrap up to 600s (the binding scenario's own 180s
# watchdog only starts AFTER the launch in step 4).
DEADLINE=$((SECONDS + 900))
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-reboot) NO_REBOOT=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "usage: run-ios.sh [--udid U] [--art-dir D] [--skip-build] [--no-reboot] [--skip-install]" >&2; exit 2 ;;
  esac
done
LOG="$ART/logs.txt"   # derived AFTER arg parsing — --art-dir must apply
# Rule 5 (fail loud): the checkers ARE the verdict. nvm-managed node is
# absent in non-interactive shells — observed live 2026-09-21: `run_check
# ... || true` masked "node: command not found" and the summary PASSed by
# grepping the PREVIOUS run's still-on-disk verdict files. Abort BEFORE the
# drive, and run_check removes its target so no stale verdict survives.
command -v node >/dev/null 2>&1 || die "node not on PATH — checkers cannot run (rule 5)"
export IDB_UDID="$UDID"
mkdir -p "$ART" "$ART/screens"

log() { echo "run-ios: $*"; }
die() { echo "run-ios: FAIL: $*" >&2; exit 1; }

shot() { xcrun simctl io "$UDID" screenshot "$ART/screens/$1.png" >/dev/null 2>&1 && log "screenshot screens/$1.png" || true; }

# ---- accessibility helpers -------------------------------------------------
# strip_hash FILE: screenshot now, crop the banner strip (px y150..410 —
# excludes the clock/dynamic island so the only change is a banner), md5 it.
# The idb AX tree is dead on this runtime, so a visual diff IS the banner
# detector; taps before the banner renders would hit springboard ICONS
# (observed live: it launched the Watch app and its permission alert).
strip_hash() { # out.png -> md5 on stdout, rc!=0 when screenshot fails
  xcrun simctl io "$UDID" screenshot /tmp/.dsh-banner-raw.png >/dev/null 2>&1 || return 9
  sips -c 260 1206 --cropOffset 150 0 /tmp/.dsh-banner-raw.png --out "$1" >/dev/null 2>&1 || return 9
  md5 -q "$1" 2>/dev/null
}

# wait_sheet: the picker sheet presents late on a cold Files daemon; poll
# the bottom-half strip hash until it turns over (sheet covers the app),
# deadline 30s — taps before that land on the app console, not the sheet.
wait_sheet() {
  local b n deadline=$((SECONDS + 30))
  b=$(strip_hash /tmp/.sheet-base.png) || return 9
  while [ "$SECONDS" -lt "$deadline" ]; do
    n=$(strip_hash /tmp/.sheet-now.png) || { sleep 1; continue; }
    [ "$n" != "$b" ] && return 0
    sleep 1
  done
  echo "run-ios:   sheet never detected — continuing anyway" >&2
  return 9
}

# ax_point LABEL: one describe-all probe; echoes "x y" (element center) when
# LABEL is present, nothing otherwise. describe-all errors on some iOS 26.5
# runtimes — any failure means "not found" and the caller falls back to the
# calibration constants above.
ax_point() {
  idb ui describe-all --udid "$UDID" --json >"$ART/.ax.json" 2>/dev/null || return 1
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

# ui_find LABEL FALLBACK_X FALLBACK_Y: ONE describe-all probe (the tree is
# dead on iOS 26.5 — this returns instantly); echoes a tap point — the
# element center when the label shows up, the calibration fallback otherwise.
ui_find() {
  local label="$1" fx="$2" fy="$3" pt=""
  pt=$(ax_point "$label") && [ -n "$pt" ] && { echo "$pt"; return 0; }
  echo "run-ios:   ax: '$label' not found — calibration fallback ($fx,$fy)" >&2
  echo "$fx $fy"
}

tap_label() { # LABEL FX FY [TIMEOUT]
  local x y; read -r x y <<<"$(ui_find "$1" "$2" "$3" "${4:-3}")"
  log "tap '$1' at ($x,$y)"; idb ui tap --udid "$UDID" "$x" "$y" >/dev/null
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

# ---- WDA (WebDriverAgent): the ONLY channel that reaches system UI --------
# (permission alerts, notification banners — springboard-owned surfaces that
# ignore idb HID injection entirely). Coordinates here are POINTS (402x874).
WDA_PID=""
# --max-time 3: during init WDA accepts TCP but stalls the response — an
# unbounded curl would hang the poll loop itself (observed live 2026-09-20).
# The status match accepts BOTH JSON spacings: WDA builds up to Sep 20 2026
# returned compact `"state":"success"`, the 16.12.9 rebuild pretty-prints
# `"state" : "success"` — matching only one spacing burns the 600s bootstrap
# window against a healthy server, then step 5 pkills it mid-run (surprise
# run-iosshs-wdaup-probe-matches, 2026-09-21).
wda_up() { curl -s --max-time 3 localhost:8100/status 2>/dev/null | grep -Eq '"state"[[:space:]]*:[[:space:]]*"success"'; }
wda_bootstrap() {
  if wda_up; then return 0; fi
  log "bootstrapping WebDriverAgent (clone/build may take minutes on first run)"
  [ -d "$HOME/dsh-e2e/wda" ] ||     git clone --depth 1 https://github.com/appium/WebDriverAgent.git "$HOME/dsh-e2e/wda" >/dev/null 2>&1
  [ -d "$HOME/dsh-e2e/wda" ] || { echo "run-ios: WDA clone failed — system-UI legs will hang" >&2; return 9; }
  [ -d "$HOME/dsh-e2e/wda-dd/Build/Products" ] ||     xcodebuild build-for-testing -scheme WebDriverAgentRunner       -destination "platform=iOS Simulator,id=$UDID"       -derivedDataPath "$HOME/dsh-e2e/wda-dd" >/dev/null 2>&1
  ( cd "$HOME/dsh-e2e/wda" && xcodebuild test-without-building -scheme WebDriverAgentRunner       -destination "platform=iOS Simulator,id=$UDID"       -derivedDataPath "$HOME/dsh-e2e/wda-dd" >/dev/null 2>&1 ) &
  WDA_PID=$!
  # True wall-clock window (SECONDS-based): a stalled probe must not eat the
  # budget, and the loop must end when the window closes, not after N hangs.
  local wda_deadline=$((SECONDS + 600))
  until wda_up; do
    [ "$SECONDS" -ge "$wda_deadline" ] && return 9
    sleep 2
  done
}
wda_session() { curl -s -X POST localhost:8100/session -H 'Content-Type: application/json' -d '{"capabilities":{}}' | python3 -c "import json,sys; print(json.load(sys.stdin)['sessionId'])"; }
# wda_tap X Y [DUR]: absolute coordinate press (points)
wda_tap() { local x=$1 y=$2 d=${3:-0.1} sid; sid=$(wda_session);   curl -s -X POST "localhost:8100/session/$sid/wda/dragfromtoforduration" -H 'Content-Type: application/json'     -d "{\"fromX\":$x,\"fromY\":$y,\"toX\":$x,\"toY\":$y,\"duration\":$d}" >/dev/null; }
# wda_click LABEL: find by accessibility label and click (works across app,
# remote-view sheets AND system alerts — idb cannot reach any of those)
wda_click() { local sid label=$1 eid; sid=$(wda_session);   eid=$(curl -s -X POST "localhost:8100/session/$sid/element" -H 'Content-Type: application/json'     -d "{\"using\":\"xpath\",\"value\":\"//*[@label=\\\"$label\\\"]\"}"     | python3 -c "import json,sys; v=json.load(sys.stdin).get('value',{}); print(v.get('ELEMENT','') if isinstance(v,dict) else (v[0]['ELEMENT'] if v else ''))" 2>/dev/null);   [ -n "$eid" ] && curl -s -X POST "localhost:8100/session/$sid/element/$eid/click" >/dev/null; }

# wda_field_type TEXT: focus the Files sheet search field through WDA and type
# into it. Verified live 2026-09-21 on the iOS 26.5 picker sheet: idb
# coordinate taps NEVER focus this field (no keyboard, placeholder intact —
# even at the exactly-derived px), while a WDA element click does (caret +
# keyboard up); wda/keys returns success but types nothing into the sheet
# field, the element /value endpoint delivers (surprise
# drivepicker-can-focus-the). The field is looked up by TYPE
# (XCUIElementTypeSearchField), not label, so the drive is locale-independent.
wda_field_type() { # TEXT
  local sid eid text=$1
  sid=$(wda_session)
  eid=$(curl -s -X POST "localhost:8100/session/$sid/element" -H 'Content-Type: application/json' \
    -d '{"using":"xpath","value":"//XCUIElementTypeSearchField"}' \
    | python3 -c "import json,sys; v=json.load(sys.stdin).get('value',{}); print(v.get('ELEMENT','') if isinstance(v,dict) else '')" 2>/dev/null)
  [ -n "$eid" ] || return 1
  curl -s -X POST "localhost:8100/session/$sid/element/$eid/click" >/dev/null
  sleep 1    # focus animation before keys
  curl -s -X POST "localhost:8100/session/$sid/element/$eid/value" -H 'Content-Type: application/json' \
    -d "{\"text\":\"$text\"}" >/dev/null
}

# wda_submit_search: the typed query alone NEVER executes the search on the
# iOS 26.5 sheet — typing renders only the 名称包含 suggestion row (observed
# live 2026-09-21: field focused, 'notes' delivered, caret + keyboard up, yet
# no result tile; the blind tile press then hit blank space and the watchdog
# expired). Appending "\n" through the SAME element /value endpoint delivers
# the keyboard return = submit — verified live: the results view rendered
# immediately. Lookup stays by TYPE, so the drive remains locale-independent.
wda_submit_search() {
  local sid eid
  sid=$(wda_session)
  eid=$(curl -s -X POST "localhost:8100/session/$sid/element" -H 'Content-Type: application/json' \
    -d '{"using":"xpath","value":"//XCUIElementTypeSearchField"}' \
    | python3 -c "import json,sys; v=json.load(sys.stdin).get('value',{}); print(v.get('ELEMENT','') if isinstance(v,dict) else '')" 2>/dev/null)
  [ -n "$eid" ] || return 1
  curl -s -X POST "localhost:8100/session/$sid/element/$eid/value" -H 'Content-Type: application/json' \
    -d '{"text":"\n"}' >/dev/null
}

# ---- UI legs ---------------------------------------------------------------
drive_banner() { # screenshot-diff gate: tap ONLY when the banner actually renders
  shot 02-notification-banner
  local deadline=$((SECONDS + 25)) base now
  log "driving notification banner (<=25s, top-strip hash diff)"
  base=$(strip_hash /tmp/.banner-base.png) || base="none"
  while [ "$SECONDS" -lt "$deadline" ]; do
    now=$(strip_hash /tmp/.banner-now.png) || { sleep 1; continue; }
    if [ "$now" != "$base" ]; then
      log "banner visible (strip changed) -> tap now"
      # the banner lives ~6s; every cycle taps three positions back-to-back
      # with no waits between them, one wait after the burst
      wda_tap 100 87 0.15
      wda_tap 133 100 0.15
      wda_tap 100 117 0.15
      if wait_line "notify.response" 2; then log "banner tap accepted"; return 0; fi
    fi
    sleep 0.5  # paces the poll; the 5s trigger is real wall-clock physics
  done
  # last resort: the banner expired into Notification Center — pull it down
  log "banner not hit — pull-down gesture, retry"
  idb ui swipe --udid "$UDID" 150 25 150 700 --duration 0.5 >/dev/null 2>&1 || true
  sleep 1.5
  shot 03-nc-pulldown
  local row
  for row in 240 320 400 480; do
    idb ui tap --udid "$UDID" 150 "$row" --duration 0.15 >/dev/null 2>&1 || true
    if wait_line "notify.response" 2; then log "NC row tap accepted"; return 0; fi
  done
  fail_deadline "notification banner never produced notify.response"
}

drive_picker() { # Files grid; a ~0.15s press on the tile = select+confirm in
  # one gesture (verified live: sheet closes and the scenario proceeds) —
  # plain zero-duration taps never select, and there is no separate 打开 to
  # press on this runtime. The log marker ui-done picker is the verdict.
  log "driving Files picker (wait sheet -> focus field via WDA -> search -> duration-press result)"
  shot 04-picker-sheet
  wait_sheet || true   # cold Files daemon presents the sheet late — detect, don't race
  sleep 5      # and its CONTENT loads a beat after the frame — early taps swallow
  idb ui tap --udid "$UDID" "${PT_ALERT_DENY[@]}" >/dev/null 2>&1 || true  # stray system alert; no-op on empty grid
  if ! wda_field_type "notes"; then   # WDA focus+type; idb fallback (works only if focus landed)
    log "wda_field_type unavailable — idb tap+text fallback"
    idb ui tap --udid "$UDID" "${PT_SEARCH[@]}" >/dev/null 2>&1 || true
    sleep 1
    idb ui text --udid "$UDID" "notes" >/dev/null 2>&1 || true
  fi
  sleep 2
  shot 05-picker-search   # typed state — suggestion row only, search not executed
  if wda_submit_search; then
    log "search submitted (keyboard return via /value)"
  else
    log "search submit unavailable — tile press will race the suggestion state"
  fi
  sleep 2
  shot 05b-picker-results   # submitted state — the result row must render here
  # the single result row sits right under the search field; a ~0.15s press
  # selects AND confirms in one gesture (verified live earlier)
  local i rc
  for i in 1 2 3; do
    idb ui tap --udid "$UDID" "${PT_FILES_TILE[@]}" --duration 0.15; rc=$?
    log "tile press $i rc=$rc"
    if wait_line "ui-done picker" 6; then
      shot 06-picker-selected
      return 0
    fi
    sleep 2
  done
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
# Reboot (not erase): erase loses the Files remembered picker location and
# the notification authorization, both of which the in-run choreography
# needs; a reboot clears transient daemons and is fast. --no-reboot keeps
# the current boot AND any warm WebDriverAgent (use right after a manual
# fresh boot, when WDA is already serving and a reboot would just re-slow it).
if [ "$NO_REBOOT" -eq 0 ]; then
  xcrun simctl shutdown "$UDID" 2>/dev/null || true
  xcrun simctl boot "$UDID" 2>/dev/null || true   # already booted is fine
fi
xcrun simctl bootstatus "$UDID" -b
sleep 5   # let springboard settle before the provider indexes the container
if [ "$SKIP_INSTALL" -eq 0 ]; then
  xcrun simctl install "$UDID" "$APP"
else
  # Reinstalling can migrate/re-touch the app's data container (observed live
  # 2026-09-21: the container UUID changed across a same-version reinstall),
  # which knocks the staged picker target out of the file-provider search
  # index. --skip-install reuses the already-installed app when the build is
  # unchanged and the pre-stage must stay undisturbed.
  log "install skipped (--skip-install) — reusing the installed app"
fi

# Pre-stage the picker target from the HOST side: the Files file-provider
# indexes the container at first touch after boot, and a file written later
# by the app itself can stay invisible to the picker for the whole run
# (observed live: picker showed an empty gateway-e2e while the file existed).
CONTAINER=$(xcrun simctl get_app_container "$UDID" "$APP_BUNDLE_ID" data)
mkdir -p "$CONTAINER/Documents/gateway-e2e"
# STAGE ONCE: rewriting the staged target immediately before the drive knocks
# it out of the file-provider search index until re-index completes (observed
# live 2026-09-21: the same setup surfaced the tile at 04:55 with the 04:52
# staging, then returned 未找到相关结果 at 04:58 right after a rewrite —
# surprise run-iossh-attempt-with-correct). A settled copy must survive the
# pre-stage untouched; only a MISSING target is created here.
if [ ! -f "$CONTAINER/Documents/gateway-e2e/notes.txt" ]; then
  printf 'gateway e2e target file — dsh-mobile m2\n' \
    > "$CONTAINER/Documents/gateway-e2e/notes.txt"
  log "pre-staged notes.txt (was missing — fresh copy)"
else
  log "notes.txt already staged — untouched (index-settle recipe)"
fi

# 3.5 WDA warm-up BEFORE the launch: the binding scenario's 180s watchdog
# starts at eval (step 4), so a slow post-reboot WDA must not eat it.
# Stale bootstrap instances from earlier runs are reaped first — two
# test-without-building instances contend on the same simulator.
log "3.5/6 WDA warm-up (pre-launch)"
if wda_up; then
  log "WDA already up — keeping it"
else
  pkill -f "xcodebuild test-without-building" 2>/dev/null || true
  pkill -f WebDriverAgentRunner-Runner 2>/dev/null || true
  sleep 2
  wda_bootstrap || echo "run-ios: WARNING: WDA unavailable — system-UI legs degraded"
fi

log "4/6 launch (log capture truncated — checker must see only this run)"
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
# Bounded: `simctl launch` has been measured taking 385 s of silence on a cold
# runner (the runtime's one-time dyld work), which is indistinguishable from a
# hang and burns the step's budget. macOS ships no `timeout`, so perl's alarm is
# the portable deadline. 142 = the deadline fired (SIGALRM) — reported as such
# rather than as a launch failure, because those are different diagnoses.
rc=0
perl -e 'alarm shift; exec @ARGV' "${DSH_LAUNCH_DEADLINE:-180}" \
  xcrun simctl launch --terminate-running-process \
    --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
    "$UDID" "$APP_BUNDLE_ID" >/dev/null || rc=$?
if [ "$rc" != "0" ]; then
  # `|| rc=$?`, not `if ! cmd; then rc=$?` — negation makes $? the inverted
  # status, which is always 0 there, so the deadline branch would be dead code.
  if [ "$rc" = "142" ]; then
    log "run-ios: LAUNCH DEADLINE ($DSH_LAUNCH_DEADLINE s) — simctl launch did not return; treating as no verdict"
  else
    log "run-ios: launch failed (exit $rc)"
  fi
  exit 1
fi

# ---- 5. driver: react to spike: markers on the live log --------------------
log "5/6 driving scenario markers (deadline 900s)"
wda_bootstrap || echo "run-ios: WARNING: WDA unavailable — system-UI legs degraded"
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
        shot 01-notification-permission
        sleep 1.5   # alert presentation completes before the press lands
        wda_click "允许" || wda_click "Allow" || idb ui tap --udid "$UDID" "${PT_ALLOW[@]}" --duration 0.15 || true ;;
      *"dsh.spike.log:"*"notify.scheduled"*)
        log "notify.scheduled seen -> HOME (background)"; idb ui button --udid "$UDID" HOME >/dev/null ;;
      *"spike: ui-wait notification-banner"*) drive_banner ;;
      *"spike: ui-wait approval"*)
        shot 03-approval
        wda_click "Approve" || tap_label "Approve" "${PT_APPROVE[@]}" ;;
      *"spike: ui-wait picker"*) drive_picker ;;
      *"spike: sequence"*)
        log "terminal marker: $line"; DONE=1; break ;;
    esac
  fi
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    fail_deadline "900s deadline — 'spike: sequence' never appeared"
  fi
done
exec 3<&-; { kill "$TAIL_PID" && wait "$TAIL_PID"; } 2>/dev/null || true

# ---- 6. checkers ------------------------------------------------------------
log "6/6 running checkers"
grep '^dsh.spike.log:' "$LOG" >"$ART/scenario.jsonl" || true
grep '^dsh.gateway.audit:' "$LOG" >"$ART/gateway-audit.jsonl" || true
PASS=0; FAIL=0; FAILED=""
run_check() { # MANIFEST OUT
  rm -f "$2"   # a failed/absent checker must never leave a stale verdict (rule 5)
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

# ---- 7. receipt (reachable ONLY on a real green run) -----------------------
# Acceptance-bar clause 3 (docs/e2e-matrix.md): every evidence dir carries
# receipt.json. Machine-authored HERE, after the summary loop above died on
# any failing checker, so a receipt can never exist without this real green
# run (never synthesized). Format mirrors the established evidence receipts
# (hosts/ios/artifacts/b3-session-live/receipt.json).
RECEIPT="$ART/receipt.json"
TREE_LINE="origin/main $(git rev-parse --short=12 HEAD)$(git diff-index --quiet HEAD -- || echo ' (dirty working tree at receipt time)')"
ENGINE_PIN="$(sed -n 's/^PIN=//p' runtime/spike/vendor/ensure.sh)"
python3 - "$ART" "$UDID" "$TREE_LINE" "$ENGINE_PIN" <<'PY'
import json, os, subprocess, sys
from datetime import datetime
art, udid, tree, engine_pin = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
out = subprocess.run(["xcrun", "simctl", "list", "devices", "-j"],
                     capture_output=True, text=True, check=True).stdout
devs = json.loads(out)["devices"]
def pretty(rt):  # com.apple.CoreSimulator.SimRuntime.iOS-26-5 -> iOS 26.5
    parts = rt.rsplit("SimRuntime.", 1)[-1].split("-")
    return parts[0] + " " + ".".join(parts[1:])
host = next(f'{d["name"]} simulator ({udid}, {pretty(rt)})'
            for rt, ds in devs.items() for d in ds if d.get("udid") == udid)
scenarios = []
for sid in ["m1-spike-boot", "m1-carrier-loopback", "m2-gateway-binding",
            "m2-gateway-audit"]:
    v = json.load(open(os.path.join(art, f"verdict-{sid}.json")))
    scenarios.append({
        "id": v["scenario"],
        "checker": f"tools/e2e/scenarios/{sid}.json",
        "events": v["logged"],
        "result": "pass" if v["pass"] else "fail",
    })
screens = sorted("screens/" + f
                 for f in os.listdir(os.path.join(art, "screens"))
                 if f.endswith(".png"))
receipt = {
    "host": "iOS " + host,
    "engine": "quickjs-ng",
    "engineVersion": engine_pin,
    "phase": ("M2 gateway binding — the native UI legs the gateway scenario "
              "blocks on (notification permission alert, banner tap, approval "
              "dialog, Files-document picker search) are driven LIVE on the "
              "simulator while the gateway/fs/http primitives answer over the "
              "real JS bridge, one-to-one against all four scenario manifests"),
    "launchConfiguration": ("default DSHSpike scenario drive (boot -> carrier "
                            "-> gateway binding -> audit); picker target "
                            "pre-staged at Documents/gateway-e2e/notes.txt, "
                            "stage-once per the provider index-settle recipe"),
    "tree": tree,
    "scenarios": scenarios,
    "runner": "tools/e2e/run-ios.sh",
    "screens": screens,
    "regressions": ("this run refreshed ONLY hosts/ios/artifacts/m2-gateway "
                    "(its four verdicts re-matched the committed manifests on "
                    "this tree); every other evidence dir carries its own "
                    "committed verdicts — see docs/e2e-matrix.md"),
    "timestamp": datetime.now().astimezone().isoformat(timespec="seconds"),
    "exitCode": 0,
}
with open(os.path.join(art, "receipt.json"), "w") as f:
    json.dump(receipt, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"run-ios: receipt written: {os.path.join(art, 'receipt.json')}")
PY
