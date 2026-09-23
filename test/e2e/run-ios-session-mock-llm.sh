#!/usr/bin/env bash
# test/e2e/run-ios-session-mock-llm.sh — local M2 "first on-device session" E2E driver.
#
# Builds DSHSpike, launches it on a booted simulator IN SESSION MODE
# (-dsh-mode session), and waits for the Web Client to mount + the
# session.mock-llm scenario to complete — NO UI interaction: the scenario
# auto-runs once the mounted page connects (host.info readiness signal),
# uses only scope "app" fs, and never presents alerts/pickers/banners.
# The captured log is verified against BOTH manifests:
#   - session-mock-llm.json         (the JS scenario's 22 events)
#   - webclient-mount.json (carrier-side mount/connection/projection)
# Screenshots are saved artifacts (screens/) — the verdict is logs only
# (docs/ARCHITECTURE.md, "E2E verification").
#
# usage: run-ios-session-mock-llm.sh [--udid U] [--art-dir D] [--skip-build] [--client mini|default]
#
# --client mini selects the SECOND Web Client variant (dsh-web-client-mini)
# via the app's launch configuration (-dsh-web-client): the carrier mounts
# and serves it and the carrier-side evidence flips to scenario ui.client-swap
# (manifest ui-client-swap.json) — the M3 UI-pluggability proof. The default
# client keeps asserting webclient-mount.json. The JS session stream
# (session-mock-llm.json) is client-independent and always checked.
#
# Rule 8 discipline: every wait polls a condition with a deadline (log
# markers); sleeps only pace the polls. Overall deadline 300s — on expiry
# it fails loud with the last 50 log lines.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART=""
SKIP_BUILD=0
CLIENT=default
APP_BUNDLE_ID=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
DEADLINE=$((SECONDS + 300))
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --client) CLIENT="$2"; shift 2 ;;
    *) echo "usage: run-ios-session-mock-llm.sh [--udid U] [--art-dir D] [--skip-build] [--client mini|default]" >&2; exit 2 ;;
  esac
done
[ "$CLIENT" = "default" ] || [ "$CLIENT" = "mini" ] \
  || { echo "run-ios-session-mock-llm: unknown --client '$CLIENT' (mini|default)" >&2; exit 2; }
CARRIER_MANIFEST=test/e2e/scenarios/webclient-mount.json
CARRIER_STEM=webclient-mount
LAUNCH_ARGS=()
if [ "$CLIENT" = "mini" ]; then
  CARRIER_MANIFEST=test/e2e/scenarios/ui-client-swap.json
  CARRIER_STEM=ui-client-swap
  LAUNCH_ARGS=(-dsh-web-client dsh-web-client-mini)
  [ -n "$ART" ] || ART="hosts/ios/artifacts/ui-pluggability"
fi
[ -n "$ART" ] || ART="hosts/ios/artifacts/session-mock-llm"
LOG="$ART/logs.txt"   # derived AFTER arg parsing — --art-dir must apply
mkdir -p "$ART" "$ART/screens"

log() { echo "run-ios-session-mock-llm: $*"; }
die() { echo "run-ios-session-mock-llm: FAIL: $*" >&2; exit 1; }

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
  echo "run-ios-session-mock-llm: DEADLINE EXPIRED: $*" >&2
  echo "----- last 50 log lines -----" >&2
  tail -n 50 "$LOG" >&2 2>/dev/null || true
  exit 1
}

# ---- 1-3. vendor, build, install -------------------------------------------
log "1/5 vendor quickjs-ng sources"
runtime/spike/vendor/ensure.sh

if [ "$SKIP_BUILD" -eq 0 ]; then
  log "2/5 xcodebuild (simulator, udid $UDID)"
  xcodebuild build -project hosts/ios/DSHSpike.xcodeproj -scheme DSHSpike \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath hosts/ios/DerivedData 2>&1 | tail -5
else
  log "2/5 skipped (--skip-build)"
fi
[ -d "$APP" ] || die "app bundle missing: $APP (build first or drop --skip-build)"

log "3/5 boot + install"
xcrun simctl bootstatus "$UDID" -b   # already booted is fine
xcrun simctl install "$UDID" "$APP"

# ---- 4. launch in session mode + watch the log markers ----------------------
log "4/5 launch (session mode; log capture truncated — checker sees only this run)"
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
xcrun simctl launch --terminate-running-process \
  --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
  "$UDID" "$APP_BUNDLE_ID" -dsh-mode session ${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"} >/dev/null

# Markers: webclient.mounted → page-loaded shot; first ws.token-delta →
# mid-stream shot; "spike: sequence session=" → final shot, then checkers.
log "waiting for Web Client mount (deadline 300s)"
wait_line "webclient.mounted" 300 || fail_deadline "webclient.mounted never appeared"
sleep 1   # let the first frames render before the shot
shot 01-webclient-loaded

log "waiting for the first streamed token delta"
wait_line "ws.token-delta" 60 \
  || fail_deadline "no token delta streamed to the mounted page"
shot 02-mid-stream

log "waiting for session completion (terminal marker)"
wait_line "spike: sequence session=" 120 || fail_deadline "terminal marker never appeared"
sleep 1
shot 03-final-transcript

# ---- 5. checkers ------------------------------------------------------------
log "5/5 running checkers"
grep '^dsh.spike.log:' "$LOG" >"$ART/scenario.jsonl" || true
PASS=0; FAILED=""
run_check() { # MANIFEST STEM
  if node test/e2e/check.mjs --manifest "$1" --log "$LOG" --out "$ART/verdict-$2.json"; then
    PASS=$((PASS + 1))
  else
    FAILED="$FAILED $2"
  fi
}
run_check test/e2e/scenarios/session-mock-llm.json session-mock-llm
run_check "$CARRIER_MANIFEST" "$CARRIER_STEM"

echo "==================== E2E summary ($ART) ===================="
for s in session-mock-llm "$CARRIER_STEM"; do
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

# ---- receipt (reachable ONLY on a real green run) ---------------------------
# Acceptance-bar clause 3 (docs/e2e-matrix.md) — via the SHARED writer.
sh test/e2e/write-receipt.sh "$ART" "$UDID" "test/e2e/run-ios-session-mock-llm.sh" \
  "M2 first on-device session: registry boots and installs the system plugins, the mock-LLM streams token deltas as an event sequence, one tool call routes through the subprocess plugin, and the session completes with the transcript — asserted one-to-one against the session manifests" \
  "-dsh-mode session${DSH_CLIENT:+ (client variant: $DSH_CLIENT)}" \
  session-mock-llm webclient-mount
