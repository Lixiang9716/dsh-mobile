#!/usr/bin/env bash
# test/e2e/run-ios-live-llm.sh — the REAL-backend LLM E2E on the iOS simulator
# (scenario `llm.live-stream`, real leg).
#
# Builds DSHSpike, stages the LLM credentials into fs scope "app"
# (Documents/profiles/default/llm-live-stream/config.json — from the environment
# ZAI_BASE_URL / ZAI_API_KEY / ZAI_MODEL, or the repo-root .env), launches
# the app in session mode with `-dsh-scenario llm-live-stream`, waits for the Web
# Client mount + the streamed deltas + the terminal marker, then verifies
# the captured log against BOTH manifests:
#   - llm-live-stream-device.json  (the JS scenario: real leg, deltas, served model,
#                          key audit)
#   - llm-live-stream-carrier.json (mount/connection/projection evidence)
# Finally it greps the captured log for the API key — the key must appear
# NOWHERE (the scenario audits its own sink; this re-checks the platform
# stream, which the sink audit cannot see).
#
# usage: run-ios-live-llm.sh [--udid U] [--art-dir D] [--skip-build]
#
# Rule 8 discipline: every wait polls a condition with a deadline; sleeps
# only pace the polls. Overall deadline 300s — on expiry it fails loud with
# the last 50 log lines. The key is written ONLY into the app container and
# is never echoed, logged, or committed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

UDID="${DSH_E2E_UDID:-A4AE41BF-026A-441E-85DF-F53522996073}"   # dsh-iphone
ART="hosts/ios/artifacts/llm-live-stream"
SKIP_BUILD=0
APP_BUNDLE_ID=org.dsh.DSHSpike
APP=hosts/ios/DerivedData/Build/Products/Debug-iphonesimulator/DSHSpike.app
DEADLINE=$((SECONDS + 300))
while [ $# -gt 0 ]; do
  case "$1" in
    --udid) UDID="$2"; shift 2 ;;
    --art-dir) ART="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "usage: run-ios-live-llm.sh [--udid U] [--art-dir D] [--skip-build]" >&2; exit 2 ;;
  esac
done
LOG="$ART/logs.txt"
mkdir -p "$ART" "$ART/screens"

log() { echo "run-ios-live-llm: $*"; }
die() { echo "run-ios-live-llm: FAIL: $*" >&2; exit 1; }

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
  echo "run-ios-live-llm: DEADLINE EXPIRED: $*" >&2
  echo "----- last 50 log lines -----" >&2
  tail -n 50 "$LOG" >&2 2>/dev/null || true
  exit 1
}

# ---- 0. credentials (fail loud when missing — rule 5; never echo them) ------
if [ -z "${ZAI_API_KEY:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
: "${ZAI_BASE_URL:?run-ios-live-llm: ZAI_BASE_URL missing (env or .env)}"
: "${ZAI_API_KEY:?run-ios-live-llm: ZAI_API_KEY missing (env or .env)}"
: "${ZAI_MODEL:?run-ios-live-llm: ZAI_MODEL missing (env or .env)}"

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

# ---- stage credentials into fs scope "app" ----------------------------------
# The reserved app scope maps to <container>/Documents/profiles/default
# (FSPrimitives.swift); the scenario reads llm-live-stream/config.json from there.
CONTAINER="$(xcrun simctl get_app_container "$UDID" "$APP_BUNDLE_ID" data)"
CFG_DIR="$CONTAINER/Documents/profiles/default/llm-live-stream"
mkdir -p "$CFG_DIR"
umask 077
printf '{"baseUrl":"%s","apiKey":"%s","model":"%s"}\n' \
  "$ZAI_BASE_URL" "$ZAI_API_KEY" "$ZAI_MODEL" > "$CFG_DIR/config.json"
log "credentials staged into the app container (never printed)"

# ---- 4. launch in session mode + watch the log markers ----------------------
log "4/5 launch (-dsh-scenario llm-live-stream; log capture truncated — checker sees only this run)"
rm -f "$LOG" "$ART/nslog-stderr.txt"
case "$LOG" in /*) LOG_ABS="$LOG" ;; *) LOG_ABS="$PWD/$LOG" ;; esac
case "$ART" in /*) NSLOG_ABS="$ART/nslog-stderr.txt" ;; *) NSLOG_ABS="$PWD/$ART/nslog-stderr.txt" ;; esac
xcrun simctl launch --terminate-running-process \
  --stdout="$LOG_ABS" --stderr="$NSLOG_ABS" \
  "$UDID" "$APP_BUNDLE_ID" -dsh-mode session -dsh-scenario llm-live-stream >/dev/null

log "waiting for Web Client mount (deadline 300s)"
wait_line "webclient.mounted" 300 || fail_deadline "webclient.mounted never appeared"
sleep 1   # let the first frames render before the shot
shot 01-webclient-loaded

log "waiting for the first streamed LLM delta (real backend — network-bound)"
wait_line '"event":"llm.delta"' 180 || fail_deadline "no LLM delta streamed"
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
run_check test/e2e/scenarios/llm-live-stream-device.json llm-live-stream-device
run_check test/e2e/scenarios/llm-live-stream-carrier.json llm-live-stream-carrier

# The key-leak re-check over the RAW platform stream (stdout + stderr).
if grep -qF "$ZAI_API_KEY" "$LOG" "$ART/nslog-stderr.txt" 2>/dev/null; then
  die "THE API KEY APPEARED IN THE CAPTURED LOG"
fi

echo "==================== E2E summary ($ART) ===================="
for s in llm-live-stream-device llm-live-stream-carrier; do
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
log "ALL CHECKERS PASS (key-leak re-check clean)"
